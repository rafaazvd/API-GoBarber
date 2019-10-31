import * as Yup from 'yup';
import { startOfHour, parseISO, isBefore, format, subHours } from 'date-fns';
import pt from 'date-fns/locale/pt';
import User from '../models/User';
import File from '../models/File';
import Appointment from '../models/Appointments';
import Notification from '../schemas/Notification';
import Queue from '../../lib/Queue';
import CancellationMail from '../jobs/CancellationMail';

class AppointmentController {
    async index(req, res){
      const {page = 1} = req.query;
      const appointments = await Appointment.findAll({
        where:{user_id: req.userId, canceled_at: null},
        order: ['date'],
        attributes:['id', 'date', 'past', 'cancelable'],
        limit: 20,
        offset:(page - 1)*20,
        include:[{
          model: User,
          as: 'provider',
          attributes:['id', 'date'],
          include:[{
            model: File,
            as: 'avatar',
            attributes:['id', 'path', 'url'],
          }]
        }]
      });
      return res.json(appointments);
    }

    async store(req, res){
      const schema = Yup.object().shape({
        provider_id: Yup.number().required(),
        date: Yup.date().required(),
      });
      // verificando se os campos obrigatorios foram preenchidos e nos conformes
      if (!(await schema.isValid(req.body))){
        return res.status(400).json({error: 'validation fails'});
      }
      const { provider_id, date } = req.body;
      // verificando se o prestador de serviço existe e se é o mesmo que pede o serviço
      const isProvider = await User.findOne({
        where: {id: provider_id, provider: true}
      });
      if(!isProvider){
        return res.status(401).json({error: 'you can only create appointments with providers'});
      }
      if(provider_id === req.userId){
        return res.status(401).json({error:'service provider cannot create appointment with itself'})
      }
      // converte a data e hora pra um formato sem minutos
      const hourStart = startOfHour(parseISO(date));
      // verifica se a data ja passou
      if(isBefore(hourStart, new Date())){
        return res.status(400).json({error:'past dates are not permitted'})
      }

      // checar disponibilidade do provider na data
      const checkAvailability = await Appointment.findOne({
        where:{
          provider_id,
          canceled_at: null,
          date: hourStart,
        }
      });
      if (checkAvailability){
        return res.status(400).json({error: 'appointment date is not available'})
      }
      // criar agendamento  e adicionar ao banco de dados
      const appointment = Appointment.create({
        user_id: req.userId,
        provider_id,
        date: hourStart,
      });
      // notificar provedor sobre o agendamento
      const user = await User.findByPk(req.userId);
      const formattedDate = format(hourStart, "'Dia 'dd' de 'MMMM', às 'H:mm'h'", {locale: pt});
      await Notification.create({
        content:`Novo agendamento de ${user.name} para ${formattedDate}`,
        user: provider_id,
      })


      return res.json(appointment);
    }

    async delete(req, res){
      const appointment = Appointment.findByPk(req.params.id, {
        include: [{
          model: User,
          as: 'provider',
          attributes: ['name', 'email']
        },
      {
        model: User,
        as: 'user',
        attributes: ['name']
      }]
      });
      if(appointment.userId !== req.userId){
        return res.status(401).json({error:"you don't have permission to cancel this appointment"});
      }
      // essa var. pega a data e hora q foi estabelecida no appnt. e subtrai 2hrs
      const dateWithSub = subHours(appointment.date, 2);
      // verifica se a mesma variavel é antes da data atual
      if (isBefore(dateWithSub, new Date())){
        return res.status(401).json({error: 'you can only cancel appointments 2 hours in advance'})
      }

      appointment.canceled_at = new Date();
      await appointment.save();

      await Queue.add(CancellationMail.key, {appointment})

      return res.json(appointment);
    }
}
export default new AppointmentController();
